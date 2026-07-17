FROM python:3.12-slim
ENV TERM=dumb
COPY spire /app/spire
COPY app.py /app/app.py
RUN chmod +x /app/spire
EXPOSE 8080
CMD ["python", "/app/app.py"]
