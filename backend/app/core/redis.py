import redis.asyncio as redis
from .config import settings

# Global Redis pool
redis_pool = redis.ConnectionPool.from_url(settings.REDIS_URL, encoding="utf-8", decode_responses=True)

def get_redis_client():
    return redis.Redis(connection_pool=redis_pool)
