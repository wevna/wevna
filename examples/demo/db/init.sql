-- Schema and seed data for the demo. Small on purpose: the point is the shape of
-- the queries, not the volume.

create table customers (
  id integer primary key,
  name text not null,
  tier text not null
);

create table orders (
  id integer primary key,
  customer_id integer not null references customers (id),
  total_cents integer not null
);

create table order_items (
  id integer primary key,
  order_id integer not null references orders (id),
  sku text not null,
  qty integer not null
);
create index order_items_order_id on order_items (order_id);

create table prices (
  sku text primary key,
  cents integer not null
);

insert into customers values
  (1, 'Ada Lovelace', 'gold'),
  (2, 'Grace Hopper', 'silver'),
  (3, 'Edsger Dijkstra', 'bronze');

insert into prices values
  ('KEYBOARD', 8900), ('MOUSE', 3900), ('MONITOR', 24900), ('CABLE', 900),
  ('DOCK', 14900), ('WEBCAM', 5900), ('HEADSET', 7900), ('STAND', 4900);

-- Six orders of four or five lines each. The services fetch the lines one at a
-- time, which is the N+1 the dashboard should flag.
insert into orders values
  (1, 1, 48500), (2, 1, 29800), (3, 2, 61900), (4, 2, 18800), (5, 3, 39900), (6, 3, 75500);

insert into order_items values
  (1, 1, 'KEYBOARD', 1), (2, 1, 'MOUSE', 1), (3, 1, 'MONITOR', 1), (4, 1, 'CABLE', 3),
  (5, 2, 'DOCK', 1), (6, 2, 'WEBCAM', 1), (7, 2, 'CABLE', 2), (8, 2, 'STAND', 1),
  (9, 3, 'MONITOR', 2), (10, 3, 'KEYBOARD', 1), (11, 3, 'HEADSET', 1), (12, 3, 'MOUSE', 1), (13, 3, 'CABLE', 1),
  (14, 4, 'HEADSET', 1), (15, 4, 'CABLE', 4), (16, 4, 'STAND', 1), (17, 4, 'WEBCAM', 1),
  (18, 5, 'DOCK', 1), (19, 5, 'MOUSE', 2), (20, 5, 'KEYBOARD', 1), (21, 5, 'CABLE', 2),
  (22, 6, 'MONITOR', 2), (23, 6, 'DOCK', 1), (24, 6, 'HEADSET', 1), (25, 6, 'WEBCAM', 1), (26, 6, 'STAND', 1);
