"""project-hub — Flask app factory. Blueprints get registered here as phases land."""
from flask import Flask

HUB_PORT = 8700


def create_app() -> Flask:
    app = Flask(__name__)

    @app.get("/health")
    def health():
        return {"ok": True, "service": "project-hub"}

    @app.get("/")
    def home():
        return (
            "<!doctype html><meta name='viewport' content='width=device-width, initial-scale=1'>"
            "<title>project-hub</title>"
            "<body style='font-family:sans-serif;background:#111;color:#eee;"
            "display:grid;place-items:center;height:100vh;margin:0'>"
            "<div style='text-align:center'><h1>project-hub</h1>"
            "<p>Phase 0 hello — the real UI lands in Phase 1.</p></div></body>"
        )

    return app


if __name__ == "__main__":
    # Reloader stays OFF permanently: APScheduler (Phase 1) double-fires under it.
    create_app().run(host="127.0.0.1", port=HUB_PORT, threaded=True, use_reloader=False)
