FROM python:3.12-slim-bookworm
RUN useradd --uid 10002 --no-create-home --shell /usr/sbin/nologin vrtproxy \
    && find / -xdev -perm /6000 -type f -exec chmod a-s {} + 2>/dev/null || true
COPY proxy.py /opt/vrt/proxy.py
RUN chmod 0555 /opt/vrt/proxy.py
USER 10002:10002
EXPOSE 3128
ENTRYPOINT ["python", "-I", "-B", "-u", "/opt/vrt/proxy.py"]
