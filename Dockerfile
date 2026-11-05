FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=8000 \
    MCP_USERS_FILE=/app/data/users.yaml

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && useradd --create-home --uid 10001 app \
    && install -d -o app -g app -m 700 /app/data

COPY --chown=app:app config/ /app/config/
COPY --chown=app:app src/ /app/src/
COPY --chown=app:app scripts/ /app/scripts/

WORKDIR /app/src
USER app

EXPOSE 8000

CMD ["python", "server.py"]