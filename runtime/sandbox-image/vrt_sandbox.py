"""Helpers available to code running inside a Vultr Agent Runtime sandbox.

    from vrt_sandbox import launch_chromium, write_result

`launch_chromium` starts Playwright Chromium wired to the job's egress proxy.
Browsers launched any other way have no network route out of the sandbox.
"""
import json
import os

OUTPUT_DIR = "/work/output"


def proxy_settings():
    server = os.environ.get("VRT_PROXY_SERVER")
    if not server:
        return None
    return {
        "server": server,
        "username": os.environ.get("VRT_PROXY_USER", ""),
        "password": os.environ.get("VRT_PROXY_PASS", ""),
        # Force loopback through the proxy as well, so it is policed and logged.
        "bypass": "<-loopback>",
    }


CHROMIUM_ARGS = [
    "--disable-gpu",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--no-first-run",
    "--proxy-bypass-list=<-loopback>",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
]


def launch_chromium(playwright, **kwargs):
    """Launch Chromium through the sandbox egress proxy."""
    args = list(CHROMIUM_ARGS) + list(kwargs.pop("args", []))
    return playwright.chromium.launch(proxy=proxy_settings(), args=args, chromium_sandbox=False, **kwargs)


def new_context(browser, **kwargs):
    kwargs.setdefault("accept_downloads", False)
    kwargs.setdefault("service_workers", "block")
    return browser.new_context(**kwargs)


def write_result(data):
    """Write structured output returned as `output` in the job result."""
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    with open(os.path.join(OUTPUT_DIR, "result.json"), "w", encoding="utf-8") as f:
        json.dump(data, f)


def read_inputs():
    try:
        with open("/work/input.json", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return None
