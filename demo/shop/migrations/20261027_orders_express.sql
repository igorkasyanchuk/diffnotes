-- orders remember the shipping speed the customer paid for
alter table orders add column express boolean not null default false;
