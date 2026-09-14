# -*- coding: utf-8 -*-
import json, pickle
exec(open('/tmp/build/pool.py').read())
exec(open('/tmp/build/pooldef.py').read())

CDISP={'United States of America':'United States','United Republic of Tanzania':'Tanzania',
 'S. Sudan':'South Sudan','Czech Republic':'Czechia','Macedonia':'North Macedonia',
 'Swaziland':'Eswatini','Cape Verde':'Cabo Verde','East Timor':'Timor-Leste',
 'Republic of Serbia':'Serbia','The Bahamas':'Bahamas','Guinea Bissau':'Guinea-Bissau',
 'Ivory Coast':"Côte d'Ivoire",'Democratic Republic of the Congo':'DR Congo',
 'Federated States of Micronesia':'Micronesia','Republic of the Congo':'Republic of the Congo'}
RDISP={'Distrito Federal':'Mexico City','Île-de-France':'Île-de-France (Paris)',
 'Lazio':'Lazio (Rome)','Berlin':'Berlin',
 'Kriti':'Crete','Attiki':'Attica','Dubay':'Dubai','Sind':'Sindh','Baluchistan':'Balochistan',
 'Gomel':'Homyel (Gomel)','Ajaria':'Adjara','Ömnögovi':'Ömnögovi (South Gobi)','Hövsgöl':'Khövsgöl',
 'Siemréab':'Siem Reap','Batdâmbâng':'Battambang','Lattakia':'Latakia','Masovian':'Masovia (Mazowieckie)',
 'Lesser Poland':'Lesser Poland (Małopolskie)','Jihomoravsky':'South Moravia','Moravskoslezsky':'Moravian-Silesian',
 'Flemish':'Flanders','Walloon':'Wallonia','Sakha (Yakutia)':'Sakha (Yakutia)','Ar Riyad':'Riyadh',
 'Makkah':'Makkah (Mecca)','Jawa Timur':'East Java','Mangghystau':'Mangystau','Bahia':'Bahia',
 'Yucatan':'Yucatán','Sao Paulo':'São Paulo','Andalucia':'Andalucía','Cataluna':'Catalonia',
 'Zurich':'Zürich','Skane':'Skåne','Kiev':'Kyiv','Bayern':'Bavaria','Sachsen':'Saxony',
 'Toscana':'Tuscany','Sicily':'Sicily','Normandie':'Normandy','Bretagne':'Brittany',
 'Noord-Holland':'North Holland','Zuid-Holland':'South Holland','Nordjylland':'North Jutland',
 'Midtjylland':'Central Jutland','Lapland':'Lapland','Uusimaa':'Uusimaa','Potosi':'Potosí',
 'Peten':'Petén','Solola':'Sololá','Islas de la Bahia':'Bay Islands','Atlantico Norte':'North Caribbean Coast',
 'Leon':'León','Itapua':'Itapúa','Kosicky':'Košice Region','Zilinsky':'Žilina Region',
 'Ysyk-Kol':'Issyk-Kul','Louangphrabang':'Luang Prabang','Preah Vihéar':'Preah Vihear',
 'Musandam':'Musandam','Dhofar':'Dhofar','Maan':"Ma'an",'Aqaba':'Aqaba','Rakhine':'Rakhine',
 'Shan':'Shan','Gorno-Badakhshan':'Gorno-Badakhshan','Khatlon':'Khatlon','Arbil':'Erbil',
 'Basra':'Basra','Cusco':'Cusco','Loreto':'Loreto','Antofagasta':'Antofagasta',
 'Los Lagos':'Los Lagos','Zulia':'Zulia','Bolivar':'Bolívar','Pinar del Rio':'Pinar del Río',
 'Santiago de Cuba':'Santiago de Cuba','Tirol':'Tyrol','Hajdu-Bihar':'Hajdú-Bihar',
 'Cluj':'Cluj','Constanta':'Constanța','Lao Cai':'Lào Cai','Kien Giang':'Kiên Giang',
 'Central Visayas (Region VII)':'Central Visayas','Cordillera Administrative Region (CAR)':'Cordillera Administrative Region',
 'Chittagong':'Chattogram (Chittagong)','Sylhet':'Sylhet','Karakalpakstan':'Karakalpakstan',
 'Samarkand':'Samarqand','Galapagos':'Galápagos','Guayas':'Guayas','Alto Paraguay':'Alto Paraguay',
 'Gracias a Dios':'Gracias a Dios','Norte':'Norte (Northern Portugal)','Algarve':'Algarve',
 'Vesturland':'Vesturland (West Iceland)','Austurland':'Austurland (East Iceland)'}

entries=[]
def add(rnd, country, region):
    res,e=find(country,region)
    assert not e, e
    if res[0]=='COUNTRY':
        keys=res[2]
        tot=sum(meta[k]['area'] for k in keys) or 1e-9
        lon=sum(meta[k]['lon']*meta[k]['area'] for k in keys)/tot
        lat=sum(meta[k]['lat']*meta[k]['area'] for k in keys)/tot
        adm=meta[keys[0]]['admin']
        label=CDISP.get(adm,adm)
        entries.append({'round':rnd,'kind':'country','name':label,'country':label,
                        'keys':keys,'lon':lon,'lat':lat,'area':tot})
    else:
        k=res[1]; v=meta[k]
        adm=v['admin']; cd=CDISP.get(adm,adm)
        entries.append({'round':rnd,'kind':'group','name':RDISP.get(v['label'],v['label']),
                        'country':cd,'keys':[k],'lon':v['lon'],'lat':v['lat'],'area':v['area']})

# Round 1: US states (exclude DC)
us=[(k,v) for k,v in meta.items() if v['admin']=='United States of America']
assert len(us)==51, (len(us),[v['label'] for k,v in us])   # 50 states and DC
for k,v in us:
    entries.append({'round':1,'kind':'group','name':v['label'],'country':'United States',
                    'keys':[k],'lon':v['lon'],'lat':v['lat'],'area':v['area']})

for rnd,dct in ((2,R2),(3,R3),(4,R4)):
    for c,regs in dct.items():
        for r in regs: add(rnd,c,r)
for c in SMALL+AFRICA: add(5,c,None)

# a country made of two separate Natural Earth units
for disp, parts in PALESTINE:
    keys=[]; tot=0.0; lon=0.0; lat=0.0
    for part in parts:
        ks=[k for k,v in meta.items() if v['admin']==part]
        for k in ks:
            v=meta[k]; keys.append(k); tot+=v['area']; lon+=v['lon']*v['area']; lat+=v['lat']*v['area']
    assert keys, disp
    entries.append({'round':5,'kind':'country','name':disp,'country':disp,
                    'keys':keys,'lon':lon/tot,'lat':lat/tot,'area':tot})

# ---- African first-level regions, tiered by how recognisable the country is ----
AFR_TIER = {
 3: ['South Africa','Egypt','Nigeria','Kenya','Morocco','Ghana','Ethiopia'],
 4: ['United Republic of Tanzania','Zimbabwe','Zambia','Mozambique','Angola','Cameroon',
     'Madagascar','Sudan','Democratic Republic of the Congo','Botswana','Namibia'],
 5: ['Algeria','Libya','Chad','Central African Republic','Mauritania','Somalia',
     'S. Sudan','Niger','Mali','Gabon','Republic of the Congo'],
}
added = 0
for rnd, countries in AFR_TIER.items():
    for adm in countries:
        ks = [k for k, v in meta.items() if v['admin'] == adm]
        assert ks, adm
        cd = CDISP.get(adm, adm)
        for k in sorted(ks, key=lambda k: -meta[k]['area']):
            v = meta[k]
            entries.append({'round':rnd,'kind':'group','name':RDISP.get(v['label'], v['label']),
                            'country':cd,'keys':[k],'lon':v['lon'],'lat':v['lat'],
                            'area':v['area'],'todo':1})
            added += 1
print('African regions added:', added)

import collections
print(collections.Counter(e['round'] for e in entries), 'total', len(entries))
json.dump(entries, open('/tmp/build/pool.json','w'), ensure_ascii=False)
