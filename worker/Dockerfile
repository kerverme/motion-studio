FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libraqm0 libcairo2 fonts-noto-core ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY fonts ./fonts
COPY engine ./engine
COPY motion_worker ./motion_worker
RUN python -c "from PIL import features; assert features.check('raqm'), 'raqm missing'; from pythainlp.tokenize import word_tokenize; print(word_tokenize('ทดสอบระบบ'))"
ENV PYTHONUNBUFFERED=1 MOTION_WORKDIR=/tmp/motion
CMD ["python", "motion_worker/main.py"]
