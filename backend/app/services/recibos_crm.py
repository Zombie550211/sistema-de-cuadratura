"""Conciliación de recibos de Google Ads que vuelve al CRM.

RRHH marca aquí (Recibos de Google Ads) el recibo que ya revisó. En cuanto cambia, se avisa al
CRM: POST {CRM_URL}/api/recibos-google/conciliacion-desde-cuadratura (clave CRM_API_KEY, la
misma de crm_push). Si el CRM no responde no pasa nada: el CRM también lo pide cada 5 minutos
(GET /integrations/crm/google-ads-receipts/reconciliation).
"""
import logging

import httpx

from app.core.config import get_settings
from app.models.google_ads import GoogleAdsReceipt

log = logging.getLogger("asistencia.recibos_crm")


def estado(r: GoogleAdsReceipt) -> dict:
    return {"crm_id": r.crm_id, "conciliado": r.reconciled, "por": r.reconciled_by,
            "en": r.reconciled_at.isoformat() if r.reconciled_at else None}


def avisar(cambios: list[dict]) -> None:
    """Para BackgroundTasks: nunca lanza."""
    s = get_settings()
    if not (s.crm_url and s.crm_api_key and cambios):
        return
    try:
        r = httpx.post(f"{s.crm_url.rstrip('/')}/api/recibos-google/conciliacion-desde-cuadratura",
                       json={"cambios": cambios}, headers={"X-API-Key": s.crm_api_key}, timeout=15)
        r.raise_for_status()
    except httpx.HTTPError as exc:
        log.warning("No se pudo avisar al CRM de la conciliación (lo recogerá en su próxima consulta): %s", exc)
