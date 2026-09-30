# Integración CRM → Sistema de cuadratura: envío de horarios

El CRM envía cada fin de semana los horarios que los supervisores cargaron para cada agente.
El sistema de cuadratura los usa para interpretar las marcaciones del reloj (entrada, salida,
tardanzas, horas extra).

## Autenticación

- Un administrador del sistema de cuadratura genera la clave en **Integración CRM → Nueva clave API**.
  La clave se muestra una sola vez y tiene el formato `cnx_…`.
- Todas las llamadas llevan el encabezado `X-API-Key: cnx_…` y van **solo por HTTPS**.
- Si la clave se filtra, se revoca desde la misma pantalla y se genera una nueva.

## 1. Probar la conexión

```http
GET /api/integrations/crm/ping
X-API-Key: cnx_…
```

```json
{ "ok": true, "cliente": "CRM Connecting", "hora_servidor": "2026-10-03T18:00:00-06:00" }
```

## 2. Enviar horarios

```http
POST /api/integrations/crm/schedules
X-API-Key: cnx_…
Idempotency-Key: crm-2026-W41-1        (opcional, recomendado)
Content-Type: application/json
```

```json
{
  "date_from": "2026-10-05",
  "date_to": "2026-10-11",
  "agents": [
    {
      "crm_agent_id": "A-100",
      "badge_number": "83",
      "first_name": "Carlos",
      "last_name": "Pérez",
      "campaign": "Ventas USA",
      "supervisor": "María Gómez",
      "shifts": [
        { "date": "2026-10-05", "start": "08:00", "end": "17:00", "break_minutes": 60 },
        { "date": "2026-10-06", "start": "22:00", "end": "06:00", "break_minutes": 30 },
        { "date": "2026-10-07", "rest_day": true }
      ]
    }
  ]
}
```

### Campos

| Campo | Obligatorio | Descripción |
|---|---|---|
| `roster_complete` | No (`false`) | `true` indica que `agents` es la lista **completa** del periodo. Ver la regla 2. |
| `date_from`, `date_to` | Sí | Periodo que cubre el envío (máximo 31 días). Normalmente lunes a domingo de la semana siguiente. |
| `agents[].crm_agent_id` | Sí | ID del agente en el CRM. Es la llave principal entre ambos sistemas. |
| `agents[].badge_number` | Recomendado | ID del agente en el **reloj de marcación**. Así el sistema enlaza sus marcas. |
| `agents[].first_name`, `last_name` | Solo si el agente es nuevo | Si el agente no existe, se crea con estos datos. Si ya existe y llegan distintos, se actualizan: el nombre del CRM es el que vale. |
| `agents[].campaign` | No | Campaña o departamento. Se crea si no existe. |
| `agents[].supervisor` | No | Informativo. |
| `shifts[].date` | Sí | Día en que **inicia** el turno (`AAAA-MM-DD`), dentro del periodo. |
| `shifts[].start`, `end` | Sí, salvo día libre | Hora local de El Salvador (`HH:MM`). Si `end` es menor que `start`, el turno termina al día siguiente. |
| `shifts[].break_minutes` | No (60) | Minutos de descanso o almuerzo no pagados. |
| `shifts[].rest_day` | No | `true` indica día libre. |
| `shifts[].notes` | No | Texto libre, hasta 500 caracteres. |

Límites por envío: 3000 agentes, un turno por agente por día y un máximo de 62 turnos por agente.

### Reglas al aplicar

1. **Reemplazo por periodo:** para cada agente enviado, sus horarios que llegaron del CRM dentro de
   `date_from`–`date_to` se reemplazan por los de este envío. Una fecha que no se envía, o que llega
   con `rest_day: true`, queda libre. Reenviar el mismo contenido no duplica nada.
2. **Agentes que no vienen en el envío:**
   - Con `roster_complete: false` (valor por defecto) no se tocan. Sirve para reenviar solo a
     los agentes que se corrigieron.
   - Con `roster_complete: true`, a los agentes que ya tenían ID de CRM en Cuadratura y no
     vienen se les quitan sus turnos **de origen CRM** dentro del periodo. Los ajustes manuales
     de RRHH se respetan. Su ficha **no** se da de baja: eso lo decide RRHH. La respuesta trae
     `agents_released` con cuántos agentes se liberaron.
   - Use `true` solo cuando el envío contiene a todos los agentes que deben tener horario ese
     periodo; un envío parcial con `true` le quitaría los turnos a los demás.
3. **Ajustes manuales de RRHH:** si RRHH cambió un día a mano en el sistema de cuadratura, ese día
   no se sobrescribe. Se devuelve como `conflicto` con la fecha afectada.
4. **Identificación del agente:** primero por `crm_agent_id`. Si no existe, por `badge_number`. Si
   tampoco existe, se crea el agente.
5. **El `badge_number` del CRM es el que vale:** si cambia, se actualiza en el sistema y las
   marcaciones se vuelven a vincular. Si ese ID de reloj ya pertenece a otro agente, ese agente
   devuelve `error` y los demás se aplican normalmente.

### Respuesta (200)

```json
{
  "sync_id": 12,
  "status": "parcial",
  "date_from": "2026-10-05",
  "date_to": "2026-10-11",
  "agents_received": 2,
  "employees_created": 1,
  "shifts_created": 2,
  "shifts_updated": 0,
  "shifts_removed": 0,
  "conflicts": 0,
  "errors": 1,
  "agents_released": 0,
  "agents": [
    { "crm_agent_id": "A-100", "status": "ok", "employee_id": 7, "employee_created": true, "message": null, "conflict_dates": [] },
    { "crm_agent_id": "A-101", "status": "error", "employee_id": null, "employee_created": false,
      "message": "El ID de reloj 50 ya está asignado a Ana López (E-050)", "conflict_dates": [] }
  ]
}
```

`status`: `ok` si todo se aplicó, `parcial` si hubo errores o conflictos en algunos agentes, y
`error` si ningún agente se pudo aplicar.

### Errores HTTP

| Código | Causa |
|---|---|
| 401 | Falta la clave, es inválida o fue revocada. |
| 422 | JSON inválido: fechas fuera del periodo, horas faltantes, agentes o fechas repetidos. No se aplica nada. |
| 5xx | Error del servidor. Reintentar con el mismo `Idempotency-Key`. |

### Idempotency-Key

Si se reenvía la misma `Idempotency-Key`, el sistema devuelve el resultado original sin volver a
aplicar nada, así que se puede reintentar sin miedo después de un timeout. Use una clave distinta
para cada envío nuevo, por ejemplo `crm-2026-W41-1` y, si hay una corrección, `crm-2026-W41-2`.

## Calendario recomendado

- **Sábado o domingo:** enviar la semana siguiente completa (lunes a domingo).
- **Correcciones durante la semana:** reenviar solo los agentes afectados, con el mismo periodo.
- Cada envío queda registrado en **Integración CRM → Envíos recibidos**, donde RRHH ve los errores
  y los conflictos.

## Ejemplo con curl

```bash
curl -X POST https://asistencia.connecting.example/api/integrations/crm/schedules \
  -H "X-API-Key: $CNX_API_KEY" \
  -H "Idempotency-Key: crm-2026-W41-1" \
  -H "Content-Type: application/json" \
  --data @horarios-semana-41.json
```
