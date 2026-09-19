FROM node:20-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential gfortran git python3 python3-dev python3-venv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json requirements-server.txt ./
RUN npm ci \
    && python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -r requirements-server.txt

COPY . .
RUN mkdir -p /app/local/pipeline /app/local/spacepy

ENV PATH="/opt/venv/bin:${PATH}" \
    PIPELINE_PYTHON=/opt/venv/bin/python \
    PIPELINE_CACHE=/app/local/pipeline \
    SPACEPY=/app/local/spacepy \
    HOST=0.0.0.0 \
    PORT=5173

EXPOSE 5173
CMD ["npm", "run", "dev"]
