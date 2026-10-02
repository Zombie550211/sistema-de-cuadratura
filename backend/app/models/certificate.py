from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Date, DateTime, ForeignKey, Numeric, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base


class SalaryCertificate(Base):
    """Constancia salarial emitida: quién la emitió, cuándo y la hoja exacta que se descargó,
    para poder volver a imprimirla igual."""

    __tablename__ = "salary_certificates"

    id: Mapped[int] = mapped_column(primary_key=True)  # folio
    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id", ondelete="CASCADE"), index=True)
    template: Mapped[str] = mapped_column(String(16))  # bono | comisiones | salario
    issue_date: Mapped[date] = mapped_column(Date)  # la fecha que dice la constancia
    salary: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    extra: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"))  # bono o comisiones
    html: Mapped[str] = mapped_column(Text)
    issued_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    # Copia del nombre: si el usuario se borra, la constancia sigue diciendo quién la emitió.
    issued_by_name: Mapped[str] = mapped_column(String(160))
    issued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)

    issued_by = relationship("User", lazy="joined")
