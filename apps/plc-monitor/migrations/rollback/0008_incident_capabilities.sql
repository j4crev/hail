BEGIN;
LOCK TABLE monitor_incident_capabilities, monitor_incident_sessions, monitor_recoveries, monitor_incident_approvals IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version > 8) OR
     EXISTS (SELECT 1 FROM monitor_incident_capabilities) OR EXISTS (SELECT 1 FROM monitor_recoveries) OR
     EXISTS (SELECT 1 FROM monitor_incident_approvals) THEN
    RAISE EXCEPTION 'Incident authorization or recovery evidence prevents rollback' USING ERRCODE = '55000';
  END IF;
END $$;
DROP TABLE monitor_recoveries, monitor_incident_sessions, monitor_incident_capabilities, monitor_incident_approvals;
DELETE FROM schema_migrations WHERE version = 8;
COMMIT;
