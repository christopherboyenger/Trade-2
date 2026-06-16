# Hosted Freqtrade for Jarvis — wraps the official image with a dry-run config
# and a minimal strategy, and exposes the REST API on :8080.
FROM freqtradeorg/freqtrade:stable

COPY config.json /freqtrade/user_data/config.json
COPY JarvisDryStrategy.py /freqtrade/user_data/strategies/JarvisDryStrategy.py

EXPOSE 8080

# Base image ENTRYPOINT is `freqtrade`; these are its args.
CMD ["trade", "--config", "/freqtrade/user_data/config.json", "--strategy", "JarvisDryStrategy"]
