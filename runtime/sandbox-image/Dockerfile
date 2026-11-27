# Disposable sandbox image for the Vultr Agent Runtime.
# Contains Python 3.12, scraping libraries, pytest and Playwright Chromium.
# Runs as an unprivileged user; the controller adds all runtime restrictions
# (gVisor, read-only rootfs, no capabilities, resource limits, network policy).
FROM python:3.12-slim-bookworm

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get update && apt-get install -y --no-install-recommends libatomic1 \
    && pip install \
        "playwright>=1.50,<2" \
        "requests>=2.32,<3" \
        "httpx>=0.27,<1" \
        "beautifulsoup4>=4.12,<5" \
        "lxml>=5,<7" \
        "pytest>=8,<10" \
    && playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* /root/.cache \
    # Strip setuid/setgid bits: nothing in the sandbox may gain privileges.
    && find / -xdev -perm /6000 -type f -exec chmod a-s {} + 2>/dev/null || true

RUN useradd --uid 10001 --create-home --home-dir /home/sandbox --shell /usr/sbin/nologin sandbox

COPY runner.py /opt/vrt/runner.py
COPY vrt_sandbox.py /usr/local/lib/python3.12/site-packages/vrt_sandbox.py
RUN chmod 0555 /opt/vrt/runner.py && chmod 0444 /usr/local/lib/python3.12/site-packages/vrt_sandbox.py \
    && python -m compileall -q /usr/local/lib/python3.12/site-packages/vrt_sandbox.py

USER 10001:10001
WORKDIR /work
ENTRYPOINT ["python", "-I", "-B", "/opt/vrt/runner.py"]
