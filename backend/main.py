from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from app.api.api import api_router
from app.db.base import Base
from app.db.session import engine
import os
from contextlib import asynccontextmanager

# Base.metadata.create_all(bind=engine) # Removed in favor of Alembic migrations

from app.core.logging import setup_logging

# Setup logging
setup_logging()

@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    from app.db.init_data import init
    init()
    yield

app = FastAPI(title="NovaStory Engine", lifespan=lifespan)

# Mount Static Files
static_dir = os.path.join(os.path.dirname(__file__), "app/static")
app.mount("/static", StaticFiles(directory=static_dir), name="static")

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # Allow frontend dev server
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router, prefix="/api")



@app.get("/")
def root():
    return {"message": "NovaStory Backend Operational"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8087, reload=True)