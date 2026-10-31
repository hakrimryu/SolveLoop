import json

from sqlalchemy.dialects.postgresql.base import ischema_names
from sqlalchemy.types import UserDefinedType


class Vector768(UserDefinedType):
    """pgvectorの固定次元型を既存のpsycopg接続で扱う。"""

    cache_ok = True

    def __init__(self, dimensions=768):
        self.dimensions = dimensions

    def get_col_spec(self, **kw):
        return f"VECTOR({self.dimensions})"

    def bind_processor(self, dialect):
        return lambda value: json.dumps(value, allow_nan=False) if value is not None else None

    def result_processor(self, dialect, coltype):
        return lambda value: json.loads(value) if isinstance(value, str) else value


ischema_names["vector"] = Vector768
