"""project-hub — Flask app factory. Modules stay small; blueprints per concern."""
from flask import Flask

from hub import auth, manifests, scheduler
from hub.config import HUB_PORT, HUB_ROOT, JOBS_DIR
from hub.media.routes import bp as media_bp
from hub.views import bp as views_bp
from hub import safepath


def create_app() -> Flask:
    app = Flask(__name__, static_folder=str(HUB_ROOT / "web"), static_url_path="/static")
    auth.install(app)
    safepath.register_root(str(JOBS_DIR))
    manifests.all_projects(force=True)          # fail fast on broken manifests at boot

    @app.get("/health")
    def health():
        return {"ok": True, "service": "project-hub",
                "projects": sorted(manifests.all_projects().keys())}

    app.register_blueprint(views_bp)
    app.register_blueprint(media_bp)
    scheduler.start()
    return app


if __name__ == "__main__":
    # Reloader stays OFF permanently: APScheduler double-fires under it.
    create_app().run(host="127.0.0.1", port=HUB_PORT, threaded=True, use_reloader=False)
