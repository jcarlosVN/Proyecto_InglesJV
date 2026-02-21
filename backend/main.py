import os
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
import logging
from routers import health, ws_speak, api_topic

logging.basicConfig(level=logging.INFO)

app = FastAPI(title="InglesJV")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(ws_speak.router)
app.include_router(api_topic.router)
app.mount("/static", StaticFiles(directory="../frontend"), name="static")


@app.get("/")
async def root():
    return FileResponse("../frontend/index.html")


if __name__ == "__main__":
    import uvicorn
    from pathlib import Path

    _dir = Path(__file__).resolve().parent
    port = int(os.getenv("PORT", 5004))
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=port,
        reload=True,
        ssl_keyfile=str(_dir / "key.pem"),
        ssl_certfile=str(_dir / "cert.pem"),
    )
