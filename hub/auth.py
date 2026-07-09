"""Optional shared-token auth (social-publisher's before_request pattern).

HUB_API_TOKEN unset => auth off; the tailnet is the perimeter either way.
Token accepted via X-Auth-Token header, ?token= query param (needed for <img>
tags), or hub_token cookie (set once by the frontend).
"""
import hmac

from flask import request

from hub.config import API_TOKEN

EXEMPT = {"/health"}


def install(app):
    if not API_TOKEN:
        return

    @app.before_request
    def _check():
        if request.path in EXEMPT:
            return None
        supplied = (
            request.headers.get("X-Auth-Token")
            or request.args.get("token")
            or request.cookies.get("hub_token")
            or ""
        )
        if not hmac.compare_digest(supplied, API_TOKEN):
            return {"error": "unauthorized"}, 401
        return None
