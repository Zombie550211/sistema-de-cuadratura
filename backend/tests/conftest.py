"""Las pruebas de API usan una base PostgreSQL real indicada en TEST_DATABASE_URL.
Si no está definida, esas pruebas se omiten (las del lector attlog corren siempre)."""

import os
import tempfile

import pytest

TEST_DB = os.environ.get("TEST_DATABASE_URL")
if TEST_DB:
    os.environ["DATABASE_URL"] = TEST_DB
os.environ["STORAGE_LOCAL_DIR"] = tempfile.mkdtemp(prefix="asistencia-test-")
os.environ.pop("FIRST_ADMIN_USERNAME", None)


@pytest.fixture(scope="session")
def engine():
    if not TEST_DB:
        pytest.skip("TEST_DATABASE_URL no definida")
    from app.core.database import engine
    from app.models import Base

    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    yield engine
    Base.metadata.drop_all(engine)


@pytest.fixture
def db(engine):
    from sqlalchemy import text

    from app.core.database import SessionLocal
    from app.models import Base

    with engine.begin() as conn:
        tables = ", ".join(t.name for t in Base.metadata.sorted_tables)
        conn.execute(text(f"TRUNCATE {tables} RESTART IDENTITY CASCADE"))
    with SessionLocal() as session:
        yield session


def _make_user(db, username, role):
    from app.core.security import hash_password
    from app.models import User

    user = User(username=username, full_name=username.title(), password_hash=hash_password("secreto123"), role=role)
    db.add(user)
    db.commit()
    return user


@pytest.fixture
def client(db):
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture
def login(client, db):
    def _login(role="admin"):
        from app.models import Role

        _make_user(db, f"u_{role}", Role(role))
        r = client.post("/api/auth/login", json={"username": f"u_{role}", "password": "secreto123"})
        assert r.status_code == 200, r.text
        return client

    return _login
