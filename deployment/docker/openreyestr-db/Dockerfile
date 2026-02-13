FROM postgres:15-alpine

# Pre-loaded OpenReyestr database (EDR - Unified State Register)
# Source: data.gov.ua dataset 1c7f3815-3259-45e0-bdf1-64dca07ddc10
# Contains: legal_entities, individual_entrepreneurs (FOP), founders, signers, beneficiaries, etc.

COPY openreyestr_dump.backup /docker-entrypoint-initdb.d/
COPY restore.sh /docker-entrypoint-initdb.d/

ENV POSTGRES_DB=openreyestr
ENV POSTGRES_USER=openreyestr
