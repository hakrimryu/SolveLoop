from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Department(Base):
    __tablename__ = "departments"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    code: Mapped[str] = mapped_column(String(32), unique=True)
    name: Mapped[str] = mapped_column(String(100))
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("role IN ('employee', 'operator')", name="ck_users_role"),
        CheckConstraint("row_version >= 1", name="ck_users_row_version"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    department_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("departments.id", ondelete="RESTRICT")
    )
    display_name: Mapped[str] = mapped_column(String(100))
    login_id: Mapped[str] = mapped_column(String(100), unique=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(16))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    can_manage_accounts: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false")
    )
    must_change_password: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false")
    )
    row_version: Mapped[int] = mapped_column(Integer, default=1, server_default=text("1"))


class AuthSession(Base):
    __tablename__ = "sessions"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    csrf_token_hash: Mapped[str] = mapped_column(String(64))


class AuditEvent(Base):
    __tablename__ = "audit_events"
    __table_args__ = (
        CheckConstraint(
            "action IN ('create', 'deactivate', 'reactivate', 'reissue', "
            "'password_change', 'management_granted')",
            name="ck_audit_action",
        ),
        CheckConstraint(
            "(action = 'management_granted' AND actor_id IS NULL) OR "
            "(action <> 'management_granted' AND actor_id IS NOT NULL)",
            name="ck_audit_actor",
        ),
        CheckConstraint(
            "action <> 'password_change' OR actor_id = target_user_id",
            name="ck_audit_password_actor",
        ),
        CheckConstraint("target_version >= 1", name="ck_audit_target_version"),
        UniqueConstraint("target_user_id", "target_version", name="uq_audit_target_version"),
        Index("ix_audit_actor_id", "actor_id"),
        Index("ix_audit_target_time", "target_user_id", text("occurred_at DESC"), text("id DESC")),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    actor_id: Mapped[UUID | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    target_user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    action: Mapped[str] = mapped_column(String(32))
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    request_id: Mapped[UUID] = mapped_column()
    target_version: Mapped[int] = mapped_column(Integer)
