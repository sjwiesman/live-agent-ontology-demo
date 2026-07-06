-- Create the UPS historian/operations database.
IF DB_ID('ups') IS NULL
BEGIN
    CREATE DATABASE ups;
END
GO

-- Materialize's SQL Server source requires snapshot isolation on the
-- replicated database so the initial snapshot reads a consistent LSN.
ALTER DATABASE ups SET ALLOW_SNAPSHOT_ISOLATION ON;
GO
