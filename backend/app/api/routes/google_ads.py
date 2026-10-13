"""Recibos de Google Ads: los envía el CRM al guardarlos y aquí son solo lectura.

- POST /integrations/crm/google-ads-receipts (clave API del CRM): un recibo con su PDF.
  Idempotente por `crm_id`: reenviar el mismo recibo no lo duplica.
- GET  /google-ads-receipts, /google-ads-receipts/summary y /google-ads-receipts/{id}/pdf:
  administradores y RRHH.

Contrato con el CRM: docs/integracion-crm.md («Recibos de Google Ads»).
"""
import hashlib
import json
import re
import uuid
from datetime import date, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, Query, Response, UploadFile, status
from pydantic import BaseModel, Field, ValidationError, field_validator
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.api.deps import DB, HR, ApiClientDep
from app.core.config import get_settings
from app.models.google_ads import GoogleAdsReceipt
from app.services.storage import get_storage

router = APIRouter(tags=["recibos google ads"])

MAX_PDF_BYTES = 10 * 1024 * 1024
STORAGE_PREFIX = "recibos_google/"
# Cuentas de la facturación del CRM (routers/recibos_google.py → CUENTAS), en su orden.
CUENTAS = ("alexis", "alexis2", "garay_lineas", "tito", "tito_lineas")


class ReceiptIn(BaseModel):
    """Datos que manda el CRM junto al PDF (campo `datos`, JSON)."""

    crm_id: int = Field(gt=0)
    fecha_pago: date
    cuenta: str
    cuenta_nombre: str = Field(min_length=1, max_length=60)
    monto_centavos: int = Field(gt=0, le=2_000_000_000)
    billing_id: str | None = Field(default=None, max_length=14)
    metodo_pago: str | None = Field(default=None, max_length=40)
    archivo_nombre: str = Field(min_length=1, max_length=160)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    subido_por: str = Field(min_length=1, max_length=150)
    creado: datetime | None = None

    @field_validator("cuenta")
    @classmethod
    def _cuenta(cls, v: str) -> str:
        if v not in CUENTAS:
            raise ValueError("cuenta desconocida")
        return v

    @field_validator("billing_id")
    @classmethod
    def _billing(cls, v: str | None) -> str | None:
        if v and not re.fullmatch(r"\d{4}-\d{4}-\d{4}", v):
            raise ValueError("el Billing ID debe tener el formato 0000-0000-0000")
        return v or None


class ReceiptOut(BaseModel):
    id: int
    crm_id: int
    payment_date: date
    account_key: str
    account_name: str
    amount_cents: int
    billing_id: str | None
    payment_method: str | None
    file_name: str
    uploaded_by: str
    received_at: datetime

    model_config = {"from_attributes": True}


class ReceiptSummary(BaseModel):
    month: str
    total_month_cents: int
    receipts: int
    last_payment: date | None


# ---------- Entrada desde el CRM ----------


@router.post("/integrations/crm/google-ads-receipts", status_code=status.HTTP_201_CREATED)
async def crm_receipt(
    db: DB,
    client: ApiClientDep,
    response: Response,
    datos: Annotated[str, Form(max_length=4000)],
    archivo: Annotated[UploadFile, File()],
):
    try:
        data = ReceiptIn.model_validate(json.loads(datos))
    except (ValueError, ValidationError) as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Datos del recibo inválidos: {e}")

    content = await archivo.read(MAX_PDF_BYTES + 1)
    if len(content) > MAX_PDF_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "El PDF pasa de 10 MB")
    if not content.startswith(b"%PDF-"):
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "El archivo no es un PDF")
    if hashlib.sha256(content).hexdigest() != data.sha256:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "El PDF no coincide con su huella (sha256)")

    existing = db.scalar(select(GoogleAdsReceipt).where(GoogleAdsReceipt.crm_id == data.crm_id))
    if existing:
        if existing.sha256 != data.sha256:
            raise HTTPException(status.HTTP_409_CONFLICT, "Ese recibo del CRM ya está registrado con otro PDF")
        response.status_code = status.HTTP_200_OK
        return {"estado": "ya_estaba", "id": existing.id}

    storage = get_storage()
    key = storage.save(f"{STORAGE_PREFIX}{uuid.uuid4().hex}.pdf", content)
    receipt = GoogleAdsReceipt(
        crm_id=data.crm_id,
        payment_date=data.fecha_pago,
        account_key=data.cuenta,
        account_name=data.cuenta_nombre,
        amount_cents=data.monto_centavos,
        billing_id=data.billing_id,
        payment_method=data.metodo_pago,
        file_name=data.archivo_nombre,
        storage_key=key,
        sha256=data.sha256,
        uploaded_by=data.subido_por,
        crm_created_at=data.creado,
        client_id=client.id,
    )
    db.add(receipt)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        storage.delete(key)
        raise HTTPException(status.HTTP_409_CONFLICT, "Ese PDF ya está registrado con otro recibo")
    return {"estado": "creado", "id": receipt.id}


# ---------- Consulta (administradores y RRHH) ----------


def _filtered(desde: date | None, hasta: date | None, cuenta: str | None, q: str | None):
    stmt = select(GoogleAdsReceipt)
    if desde:
        stmt = stmt.where(GoogleAdsReceipt.payment_date >= desde)
    if hasta:
        stmt = stmt.where(GoogleAdsReceipt.payment_date <= hasta)
    if cuenta:
        stmt = stmt.where(GoogleAdsReceipt.account_key == cuenta)
    if q and q.strip():
        stmt = stmt.where(GoogleAdsReceipt.billing_id.contains(q.strip(), autoescape=True))
    return stmt


@router.get("/google-ads-receipts", response_model=list[ReceiptOut])
def list_receipts(
    db: DB,
    _: HR,
    desde: date | None = None,
    hasta: date | None = None,
    cuenta: str | None = Query(None, max_length=40),
    q: str | None = Query(None, max_length=14),
):
    rows = db.scalars(_filtered(desde, hasta, cuenta, q)).all()
    order = {k: i for i, k in enumerate(CUENTAS)}
    # Por fecha (más reciente primero) y, dentro de cada día, en el orden de las cuentas.
    return sorted(rows, key=lambda r: (-r.payment_date.toordinal(), order.get(r.account_key, 99), r.id))


@router.get("/google-ads-receipts/summary", response_model=ReceiptSummary)
def receipts_summary(db: DB, _: HR):
    """Total pagado en el mes actual (hora de El Salvador), cantidad de recibos y último pago."""
    first = datetime.now(get_settings().tz).date().replace(day=1)
    next_month = (first + timedelta(days=32)).replace(day=1)
    total = db.scalar(
        select(func.coalesce(func.sum(GoogleAdsReceipt.amount_cents), 0)).where(
            GoogleAdsReceipt.payment_date >= first, GoogleAdsReceipt.payment_date < next_month
        )
    )
    count = db.scalar(select(func.count()).select_from(GoogleAdsReceipt))
    last = db.scalar(select(func.max(GoogleAdsReceipt.payment_date)))
    return ReceiptSummary(month=first.strftime("%Y-%m"), total_month_cents=total or 0, receipts=count or 0, last_payment=last)


@router.get("/google-ads-receipts/{receipt_id}/pdf")
def receipt_pdf(receipt_id: int, db: DB, _: HR, descargar: bool = False):
    receipt = db.get(GoogleAdsReceipt, receipt_id)
    if receipt is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Recibo no encontrado")
    try:
        content = get_storage().load(receipt.storage_key)
    except FileNotFoundError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "El PDF de este recibo no está en el servidor")
    safe = re.sub(r'[^\w.\- ]', "_", receipt.file_name)
    disposition = "attachment" if descargar else "inline"
    return Response(
        content,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'{disposition}; filename="{safe}"',
            "Cache-Control": "private, no-store",
        },
    )
