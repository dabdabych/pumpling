from pathlib import Path
from sqlalchemy import text
from infrastructure.database.database import engine


def run_migrations() -> None:
    migrations_dir = Path(__file__).resolve().parent / "migrations"
    if not migrations_dir.exists():
        return

    raw_conn = engine.raw_connection()
    try:
        cursor = raw_conn.cursor()
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
                id TEXT PRIMARY KEY,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        raw_conn.commit()

        cursor.execute("SELECT id FROM schema_migrations")
        applied = {row[0] for row in cursor.fetchall()}

        for path in sorted(migrations_dir.glob("*.sql")):
            migration_id = path.name
            if migration_id in applied:
                continue
            sql = path.read_text(encoding="utf-8")

            needs_autocommit = "ALTER TYPE" in sql and "ADD VALUE" in sql
            if needs_autocommit:
                raw_conn.autocommit = True
            try:
                cursor.execute(sql)
            finally:
                if needs_autocommit:
                    raw_conn.autocommit = False

            cursor.execute(
                "INSERT INTO schema_migrations (id) VALUES (%s)",
                (migration_id,),
            )
            raw_conn.commit()
    finally:
        raw_conn.close()
