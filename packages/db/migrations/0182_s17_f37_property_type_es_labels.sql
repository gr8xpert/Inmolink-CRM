-- S17-F37: "Plot" and "Semi-Detached House" showed in English under /es/ because the platform catalog had no Spanish
-- translation for them (the taxonomy falls back to English per row). Adds the Spanish name for the property types
-- whose English name matches, only where no Spanish translation exists yet. Idempotent; a slug already taken in
-- Spanish is left alone (staff can set the translation in the taxonomy editor).
insert into property_type_translations (type_id, locale, name, slug)
select t.type_id, 'es', m.es_name, m.es_slug
  from property_type_translations t
  join (values
    ('plot', 'Parcela', 'parcela'),
    ('semi-detached house', 'Casa pareada', 'casa-pareada'),
    ('semi-detached', 'Casa pareada', 'casa-pareada')
  ) as m(en_name, es_name, es_slug) on lower(t.name) = m.en_name
 where t.locale = 'en'
   and not exists (select 1 from property_type_translations x where x.type_id = t.type_id and x.locale = 'es')
on conflict do nothing;
