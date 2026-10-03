# shop

A small Flask shop API. Redis backs the per-client rate limiter
(`shop/rate_limit.py`); product data lives in Postgres.

    pip install -r requirements.txt
    REDIS_URL=redis://localhost:6379/0 DATABASE_URL=postgres://... flask --app shop run
