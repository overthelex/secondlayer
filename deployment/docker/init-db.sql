-- PostgreSQL initialization script for SecondLayer
-- Creates users and databases with proper credentials from environment
-- This script runs automatically when PostgreSQL container starts for the first time

-- Get values from POSTGRES_USER and POSTGRES_PASSWORD environment variables
-- Default values if not provided
\set pg_user 'secondlayer'
\set pg_password 'local_dev_password'
\set pg_db 'secondlayer_local'

-- Create application user if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_user WHERE usename = :'pg_user') THEN
    EXECUTE format('CREATE USER %I WITH PASSWORD %L', :'pg_user', :'pg_password');
    EXECUTE format('ALTER USER %I CREATEDB SUPERUSER', :'pg_user');
    RAISE NOTICE 'Created user: %', :'pg_user';
  ELSE
    RAISE NOTICE 'User already exists: %', :'pg_user';
  END IF;
END
$$;

-- Create application database if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'pg_db') THEN
    EXECUTE format('CREATE DATABASE %I OWNER %I', :'pg_db', :'pg_user');
    RAISE NOTICE 'Created database: %', :'pg_db';
  ELSE
    RAISE NOTICE 'Database already exists: %', :'pg_db';
  END IF;
END
$$;

-- Grant privileges
DO $$
BEGIN
  EXECUTE format('GRANT ALL PRIVILEGES ON DATABASE %I TO %I', :'pg_db', :'pg_user');
  RAISE NOTICE 'Granted privileges to %', :'pg_user';
END
$$;
