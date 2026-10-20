-- S6-08 freshness via feed: a connection's last content change, from the runs still kept (90 days). A connection
-- with no such run stays null: its runs confirm nothing until one adds, changes or removes an item.
update feed_connections c
   set content_changed_at = r.changed_at
  from (select connection_id, max(finished_at) as changed_at
          from feed_runs
         where state = 'SUCCEEDED' and items_created + items_updated + items_withdrawn > 0
         group by connection_id) r
 where r.connection_id = c.id;
