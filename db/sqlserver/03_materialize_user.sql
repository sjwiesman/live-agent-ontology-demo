-- Create the login/user/role Materialize connects with, per
-- https://materialize.com/docs/ingest-data/sql-server/self-hosted/
USE master;
GO

IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = 'materialize')
BEGIN
    CREATE LOGIN materialize WITH PASSWORD = '$(MZ_SQLSERVER_PASSWORD)', DEFAULT_DATABASE = ups;
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'materialize')
    CREATE USER materialize FOR LOGIN materialize;
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'materialize_role')
    CREATE ROLE materialize_role;
GO
ALTER ROLE materialize_role ADD MEMBER materialize;
GO

-- Schema discovery for replicated tables.
GRANT SELECT ON INFORMATION_SCHEMA.KEY_COLUMN_USAGE TO materialize_role;
GRANT SELECT ON INFORMATION_SCHEMA.TABLE_CONSTRAINTS TO materialize_role;
GRANT SELECT ON OBJECT::INFORMATION_SCHEMA.TABLE_CONSTRAINTS TO materialize_role;
GO

-- LSN range checks so the source can track replication progress.
GRANT EXECUTE ON sys.fn_cdc_get_min_lsn TO materialize_role;
GRANT EXECUTE ON sys.fn_cdc_get_max_lsn TO materialize_role;
GRANT EXECUTE ON sys.fn_cdc_increment_lsn TO materialize_role;
GRANT VIEW SERVER STATE TO materialize;
GO

USE ups;
GO

IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'materialize')
    CREATE USER materialize FOR LOGIN materialize;
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'materialize_role')
    CREATE ROLE materialize_role;
GO
ALTER ROLE materialize_role ADD MEMBER materialize;
ALTER ROLE db_datareader ADD MEMBER materialize;
GO
