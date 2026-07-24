from fastapi import APIRouter
from .endpoints import structure, creative, assets, projects, characters, workflows, timeline, settings, agent_assistant, coverage, comics

api_router = APIRouter()

api_router.include_router(projects.router, prefix="/projects", tags=["projects"])
api_router.include_router(characters.router, prefix="/characters", tags=["characters"])
api_router.include_router(workflows.router, prefix="/workflows", tags=["workflows"])
api_router.include_router(structure.router, prefix="/chapters", tags=["structure"])
api_router.include_router(creative.router, prefix="/agent", tags=["creative"])
api_router.include_router(agent_assistant.router, prefix="/assistant", tags=["assistant"])
api_router.include_router(assets.router, prefix="/assets", tags=["assets"])
api_router.include_router(timeline.router, prefix="/timeline", tags=["timeline"])
api_router.include_router(coverage.router, tags=["coverage"])
api_router.include_router(settings.router, prefix="/settings", tags=["settings"])
api_router.include_router(comics.router, prefix="/comics", tags=["comics"])
