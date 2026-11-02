FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends git tesseract-ocr \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir uv==0.6.3
RUN useradd -m -u 1000 user && mkdir -p /home/user/app && chown user:user /home/user/app
USER user
ENV PATH=/home/user/app/.venv/bin:$PATH PYTHONUNBUFFERED=1 HF_HOME=/home/user/.cache/huggingface
WORKDIR /home/user/app
COPY --chown=user pyproject.toml uv.lock ./
RUN uv export --frozen --no-dev --no-hashes --no-emit-project --prune torch -o requirements.txt \
    && python -m venv .venv \
    && uv pip install 'torch==2.13.0' --index-url https://download.pytorch.org/whl/cpu \
    && uv pip install -r requirements.txt
COPY --chown=user server.py documents.py examples.json ./
RUN python server.py --check
COPY --chown=user index.html style.css app.js lessons.js ./
COPY --chown=user vendor ./vendor
EXPOSE 7860
CMD ["python", "server.py", "--host", "0.0.0.0", "--port", "7860"]
