# Dibangun dari root repo: docker compose -f deploy/docker-compose.yml up -d
FROM python:3.12-slim
WORKDIR /app
COPY server/requirements.txt server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt
COPY server/ server/
COPY web/ web/
ENV DB_PATH=/data/sigap.db WEB_DIR=/app/web
VOLUME /data
EXPOSE 8000
WORKDIR /app/server
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
