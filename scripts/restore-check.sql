-- Konsistenzprüfung nach Wiederherstellung (S12): Lösch-/Sperrentscheidungen müssen erhalten sein.
select 'sources' as objekt, count(*) as anzahl from sources
union all select 'sources_locked', count(*) from sources where is_locked
union all select 'sources_erased', count(*) from sources where body is null and title = '[Inhalt gelöscht]'
union all select 'source_versions_with_body_of_erased', count(*) from source_versions v join sources s on s.id = v.source_id where s.title = '[Inhalt gelöscht]' and v.body is not null
union all select 'audit_events', count(*) from audit_events
union all select 'suggestions_superseded', count(*) from suggestions where status = 'UEBERHOLT';
