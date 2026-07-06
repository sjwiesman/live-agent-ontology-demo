-- Enable Change Data Capture on the database and every table the context
-- graph ingests. @supports_net_changes=0 because Materialize consumes the
-- full change stream, not net changes.
USE ups;
GO

EXEC sys.sp_cdc_enable_db;
GO

-- historian
EXEC sys.sp_cdc_enable_table @source_schema='historian', @source_name='tags',           @role_name='materialize_role', @supports_net_changes=0;
EXEC sys.sp_cdc_enable_table @source_schema='historian', @source_name='tag_values',     @role_name='materialize_role', @supports_net_changes=0;
EXEC sys.sp_cdc_enable_table @source_schema='historian', @source_name='alarms',         @role_name='materialize_role', @supports_net_changes=0;
GO

-- ops
EXEC sys.sp_cdc_enable_table @source_schema='ops', @source_name='facilities',   @role_name='materialize_role', @supports_net_changes=0;
EXEC sys.sp_cdc_enable_table @source_schema='ops', @source_name='equipment',    @role_name='materialize_role', @supports_net_changes=0;
EXEC sys.sp_cdc_enable_table @source_schema='ops', @source_name='routes',       @role_name='materialize_role', @supports_net_changes=0;
EXEC sys.sp_cdc_enable_table @source_schema='ops', @source_name='trailers',     @role_name='materialize_role', @supports_net_changes=0;
EXEC sys.sp_cdc_enable_table @source_schema='ops', @source_name='packages',     @role_name='materialize_role', @supports_net_changes=0;
EXEC sys.sp_cdc_enable_table @source_schema='ops', @source_name='scan_events',  @role_name='materialize_role', @supports_net_changes=0;
GO

-- fleet
EXEC sys.sp_cdc_enable_table @source_schema='fleet', @source_name='vehicles',           @role_name='materialize_role', @supports_net_changes=0;
EXEC sys.sp_cdc_enable_table @source_schema='fleet', @source_name='drivers',            @role_name='materialize_role', @supports_net_changes=0;
EXEC sys.sp_cdc_enable_table @source_schema='fleet', @source_name='fault_codes',        @role_name='materialize_role', @supports_net_changes=0;
EXEC sys.sp_cdc_enable_table @source_schema='fleet', @source_name='vehicle_faults',     @role_name='materialize_role', @supports_net_changes=0;
EXEC sys.sp_cdc_enable_table @source_schema='fleet', @source_name='maintenance_orders', @role_name='materialize_role', @supports_net_changes=0;
GO

-- Default capture-job polling is 5s; drop it to 1s so end-to-end reaction
-- time is dominated by nothing (SQL Server CDC is the floor, Materialize
-- adds ~100ms). The capture job is stopped here and restarted by init.sh
-- (a raced auto-restart by the agent still picks up the new interval).
EXEC sys.sp_cdc_change_job @job_type='capture', @pollinginterval=1;
GO
EXEC sys.sp_cdc_stop_job @job_type='capture';
GO
