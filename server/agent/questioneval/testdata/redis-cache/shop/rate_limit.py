from .redis_client import client

WINDOW_SECONDS = 60
MAX_REQUESTS = 120


def allow(client_id: str) -> bool:
    key = f"rate:{client_id}"
    count = client.incr(key)
    if count == 1:
        client.expire(key, WINDOW_SECONDS)
    return count <= MAX_REQUESTS
