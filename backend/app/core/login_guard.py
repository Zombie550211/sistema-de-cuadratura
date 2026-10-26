"""Freno de fuerza bruta para el login (en memoria del proceso).

El despliegue corre un solo worker de uvicorn, así que un dict en memoria basta;
un reinicio limpia los contadores, lo cual es aceptable para este fin. Hay dos
frenos independientes:

- Por IP: ventana deslizante que limita el ritmo de intentos desde un mismo origen.
- Por cuenta: tras varios fallos seguidos sobre el MISMO usuario se bloquea esa
  cuenta un rato, aunque el atacante cambie de IP (botnet).

Un login correcto limpia el contador de esa cuenta.
"""
import time

# Por IP: ventana deslizante.
_IP_MAX = 10          # intentos permitidos por ventana
_IP_WINDOW = 60       # segundos de la ventana
_ip_hits: dict[str, list[float]] = {}

# Por cuenta: fallos seguidos antes de bloquear y duración del bloqueo.
_ACC_MAX_FALLOS = 8
_ACC_BLOQUEO_SEGS = 15 * 60
# username_normalizado -> {"n": fallos, "hasta": epoch_desbloqueo}
_acc_fallos: dict[str, dict] = {}


def _norm(username: str) -> str:
    return (username or "").strip().lower()


def ip_bloqueada(ip: str) -> bool:
    """True si esta IP superó el límite de intentos dentro de la ventana."""
    ahora = time.time()
    hits = [t for t in _ip_hits.get(ip, []) if ahora - t < _IP_WINDOW]
    _ip_hits[ip] = hits
    return len(hits) >= _IP_MAX


def registra_ip(ip: str) -> None:
    _ip_hits.setdefault(ip, []).append(time.time())


def cuenta_bloqueada(username: str) -> int:
    """Segundos de bloqueo que le quedan a la cuenta (0 si no está bloqueada)."""
    e = _acc_fallos.get(_norm(username))
    if not e:
        return 0
    restante = int(e.get("hasta", 0) - time.time())
    return restante if restante > 0 else 0


def registra_fallo_cuenta(username: str) -> None:
    k = _norm(username)
    e = _acc_fallos.get(k) or {"n": 0, "hasta": 0}
    e["n"] += 1
    if e["n"] >= _ACC_MAX_FALLOS:
        e["hasta"] = time.time() + _ACC_BLOQUEO_SEGS
        e["n"] = 0  # reinicia el conteo; el bloqueo temporal toma el relevo
    _acc_fallos[k] = e


def limpia_cuenta(username: str) -> None:
    _acc_fallos.pop(_norm(username), None)


def _reset() -> None:
    """Vacía los contadores. Para aislar las pruebas (no usar en producción)."""
    _ip_hits.clear()
    _acc_fallos.clear()
