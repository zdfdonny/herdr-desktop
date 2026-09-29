"""Hermes plugin installed by herdr-desktop to report session identity."""

# HERDR_INTEGRATION_ID=herdr-desktop
# HERDR_INTEGRATION_VERSION=2

from __future__ import annotations

import json
import os
import urllib.request

_SOURCE = "herdr:hermes"
_AGENT = "hermes"


def _report(payload):
    url = os.environ.get("HERDR_DESKTOP_REPORT_URL")
    pane_id = os.environ.get("HERDR_DESKTOP_PANE_ID")
    if not url or not pane_id:
        return
    body = json.dumps({"paneId": pane_id, "source": _SOURCE, "agent": _AGENT, **payload}).encode()
    req = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        urllib.request.urlopen(req, timeout=1)
    except Exception:
        pass


def _report_session(**kwargs):
    if kwargs.get("platform") not in {"cli", "tui", "desktop", "acp"}:
        return
    session_id = kwargs.get("session_id")
    if isinstance(session_id, str) and session_id:
        _report({"sessionId": session_id})


def _on_session_start(**kwargs):
    _report_session(**kwargs)


def _on_llm_call(**kwargs):
    if kwargs.get("platform") in {"cli", "tui", "desktop", "acp"}:
        _report({"state": "working"})


def register(ctx):
    ctx.register_hook("on_session_start", _on_session_start)
    ctx.register_hook("pre_llm_call", _on_llm_call)
