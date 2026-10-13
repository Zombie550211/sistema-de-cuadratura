# Integración CRM → Sistema de cuadratura: envío de horarios

El CRM envía cada fin de semana los horarios que los supervisores cargaron para cada agente.
El sistema de cuadratura los usa para interpretar las marcaciones del reloj (entrada, salida,
tardanzas, horas extra).

**El CRM solo manda horarios.** La planilla de personal se lleva en **Empleados** del sistema de
cuadratura (fichas registradas a mano o con la nómina importada). Un agente que no está registrado
ahí se rechaza: RRHH lo registra y el CRM vuelve a enviar su horario.

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
| `agents[].badge_number` | Recomendado | ID del agente en el **reloj de marcación**. Sirve para encontrarlo en Empleados; solo se guarda si su ficha aún no tiene ID de reloj. |
| `agents[].first_name`, `last_name` | Recomendado | Sirven para encontrar al agente en Empleados la primera vez (basta el nombre corto: "Bryan Pleitez"). No cambian el nombre de la ficha. |
| `agents[].campaign` | No | Team del agente. Se crea si no existe y se asigna al agente. |
| `agents[].hire_date` | No | Informativo: la fecha de ingreso la lleva Empleados y no se modifica. |
| `agents[].supervisor` | No | Informativo. |
| `shifts[].date` | Sí | Día en que **inicia** el turno (`AAAA-MM-DD`), dentro del periodo. |
| `shifts[].start`, `end` | Sí, salvo día libre | Hora local de El Salvador (`HH:MM`). Si `end` es menor que `start`, el turno termina al día siguiente. |
| `shifts[].break_minutes` | No (60) | Minutos de descanso o almuerzo no pagados. |
| `shifts[].rest_day` | No | `true` indica día libre. |
| `shifts[].notes` | No | Texto libre, hasta 500 caracteres. |

Límites por envío: 3000 agentes, un turno por agente por día y un máximo de 62 turnos por agente.

### Reglas al aplicar

1. **Reemplazo por periodo:** para cada agente enviado, su horario dentro de
   `date_from`–`date_to` queda como el de este envío (también los días que RRHH había cambiado
   aquí: esos cambios ya se le devolvieron al CRM, ver "Sincronización de vuelta"). Una fecha que no se envía, o que llega
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
3. **Cambios de RRHH:** un día que RRHH cambió en Cuadratura y que aún no llegó al CRM no se toca.
   Una vacación o un compensatorio de RRHH no se pisa con un turno: se devuelve como `conflicto`
   con la fecha y se le vuelve a enviar al CRM como descanso.
4. **Identificación del agente:** primero por `crm_agent_id`. Si no existe, por `badge_number` y
   después por nombre entre los empleados que aún no tienen ID de CRM; al encontrarlo se le guarda
   el `crm_agent_id`. Si no está en Empleados, ese agente devuelve `error` ("no está en
   Empleados") y los demás se aplican normalmente. El sistema **no crea empleados**.
5. **La ficha de Empleados es la que vale:** el envío no cambia nombre, fecha de ingreso ni ID de
   reloj. Si la ficha no tiene ID de reloj, se guarda el `badge_number` del envío y sus marcaciones
   se vinculan; si ese ID ya pertenece a otro empleado, el agente devuelve `error`.

### Respuesta (200)

```json
{
  "sync_id": 12,
  "status": "parcial",
  "date_from": "2026-10-05",
  "date_to": "2026-10-11",
  "agents_received": 2,
  "employees_created": 0,
  "shifts_created": 2,
  "shifts_updated": 0,
  "shifts_removed": 0,
  "conflicts": 0,
  "errors": 1,
  "agents_released": 0,
  "agents": [
    { "crm_agent_id": "A-100", "status": "ok", "employee_id": 7, "employee_created": false, "message": null, "conflict_dates": [] },
    { "crm_agent_id": "A-101", "status": "error", "employee_id": null, "employee_created": false,
      "message": "El agente Ana López no está en Empleados: regístrelo en la planilla (con su ID de reloj o su nombre completo) y vuelva a enviar el horario", "conflict_dates": [] }
  ]
}
```

`employees_created` y `employee_created` se mantienen por compatibilidad y ahora siempre son `0` /
`false`.

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

## Sincronización de vuelta (Cuadratura → CRM)

Horarios del CRM y de Cuadratura deben ser iguales. Cada cambio que RRHH hace en Cuadratura (asignar,
reagendar o quitar un turno, dar un día libre, una vacación o un compensatorio) se envía al CRM:

```
POST {CRM_URL}/api/horarios/desde-cuadratura
X-API-Key: <CRM_API_KEY de Cuadratura = CUADRATURA_ENTRADA_KEY del CRM>

{"changes": [
  {"crm_agent_id": "152", "date": "2026-10-12", "start": "08:00", "end": "17:00", "break_minutes": 60, "notes": null},
  {"crm_agent_id": "152", "date": "2026-10-13", "rest_day": true, "notes": "Vacación"},
  {"crm_agent_id": "152", "date": "2026-10-14", "clear": true}
]}
```

- Cada cambio reemplaza ese día del agente en el CRM; `clear` lo deja vacío (libre).
- Los cambios salen de una cola (`crm_outbox`): se envían al guardar y, si el CRM no responde, se
  reintentan cada 5 minutos. Mientras un día está en la cola, el envío del CRM no lo pisa.
- Solo viajan los empleados con ID de CRM.
- Configuración en el `.env` de Cuadratura: `CRM_URL` y `CRM_API_KEY`. Sin ellas no se envía nada
  (y los cambios de RRHH quedan en la cola hasta que se configure).

## 3. Recibos de Google Ads (CRM → Cuadratura, solo lectura)

Los administradores registran en el CRM los pagos de Google Ads con su comprobante PDF
(Facturación → Recibos Google Ads). El CRM envía cada recibo aquí al guardarlo y reintenta
cada 5 min los que no llegaron (también los que ya existían). En Cuadratura se ven en
**Recibos Google Ads** (administradores y RRHH) y no se pueden editar.

```
POST /api/integrations/crm/google-ads-receipts
X-API-Key: cnx_…
Content-Type: multipart/form-data
  datos   = JSON (ver campos)
  archivo = el PDF (máx. 10 MB, debe empezar por %PDF-)
```

| Campo | Tipo | Notas |
|---|---|---|
| `crm_id` | entero | id del recibo en el CRM; **clave de idempotencia** |
| `fecha_pago` | AAAA-MM-DD | |
| `cuenta` | texto | `alexis`, `alexis2`, `garay_lineas`, `tito`, `tito_lineas` |
| `cuenta_nombre` | texto | nombre para mostrar (Alexis, Garay Líneas…) |
| `monto_centavos` | entero > 0 | |
| `billing_id` | texto o null | formato `0000-0000-0000` |
| `metodo_pago` | texto o null | p. ej. `Mastercard •••• 1023` |
| `archivo_nombre` | texto | nombre original del PDF |
| `sha256` | hex (64) | huella del PDF; debe coincidir con el archivo enviado |
| `subido_por` | texto | usuario del CRM |
| `creado` | fecha-hora ISO o null | cuándo se registró en el CRM |

Respuestas: **201** `{"estado": "creado"}` · **200** `{"estado": "ya_estaba"}` (ese `crm_id` ya
llegó con el mismo PDF: reenviar no duplica) · **409** ese `crm_id` ya existe con otro PDF, o ese
PDF ya está con otro recibo · **413** más de 10 MB · **415** no es PDF · **422** datos inválidos o
huella que no coincide · **401** clave inválida.

Los PDF se guardan en el almacenamiento de la app (`recibos_google/<uuid>.pdf`) y solo se
entregan por `GET /api/google-ads-receipts/{id}/pdf` con sesión de administrador o RRHH.

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
