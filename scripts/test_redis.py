import redis
import sys

# Configuration matches backend/app/core/config.py default
REDIS_HOST = 'localhost'
REDIS_PORT = 6379
REDIS_DB = 0

def test_redis_connection():
    print(f"Testing connection to Redis at {REDIS_HOST}:{REDIS_PORT} (DB: {REDIS_DB})...")
    
    try:
        client = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, db=REDIS_DB, socket_connect_timeout=5)
        response = client.ping()
        
        if response:
            print("✅ Success: Redis is reachable and responding.")
        else:
            print("⚠️  Warning: Redis is reachable but returned unexpected response.")
            
    except redis.ConnectionError as e:
        print("❌ Error: Could not connect to Redis.")
        print(f"   Details: {e}")
        print("\nPossible solutions:")
        print("1. Ensure the Redis server is running.")
        print("   - If installed via Windows Service: Check 'Services' (services.msc).")
        print("   - If installed via WSL/Docker: Ensure the container/process is up.")
        print(f"2. Verify the host and port are correct ({REDIS_HOST}:{REDIS_PORT}).")
        
    except Exception as e:
        print(f"❌ An unexpected error occurred: {e}")

if __name__ == "__main__":
    test_redis_connection()
