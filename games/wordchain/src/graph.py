from wordfreq import top_n_list, zipf_frequency as z
import re, json, random
from collections import defaultdict

exec(open('gen2.py').read().split('print("compounds:")')[0].split('print(')[0])

BAD = set("""capability surface donkey soledad riddance condon lipton boateng marcella subspace
recline cornish afterall godwin highgate watertown greenspan sharepoint neoliberal paralegal
photocopy ontological boateng marcella subspace""".split())

edges = defaultdict(set)
pairinfo = {}
for w, splits in compounds.items():
    if w in BAD: continue
    for a,b in splits:
        edges[a].add(b)
        pairinfo[(a,b)] = ('closed', round(z(w,'en'),2), w)

# curated open phrases: left, right
OPEN = """game:on take:stock bow:out cut:back call:off pull:over hold:up break:down
knock:out check:in turn:down give:up run:down set:up tune:in pass:out throw:up
shelf:life open:house close:call high:road free:fall dead:end blind:spot soft:spot
sweet:tooth cold:shoulder green:light red:tape black:market first:aid second:hand
short:list long:shot last:call full:house half:time front:line back:seat
top:dollar rock:bottom gold:mine silver:lining home:run ball:park press:box
side:effect stock:option option:trade market:share share:price price:tag
name:tag tag:line line:up up:hill hill:top top:notch
face:value value:add add:on on:call call:sign sign:off off:hand hand:out
out:take take:away away:game game:plan plan:ahead ahead:start start:up
small:talk talk:show show:case case:study study:group group:think think:tank
tank:top top:coat coat:rack rack:up up:beat beat:box box:office office:hours
point:blank blank:check check:mate mate:ship pipe:dream dream:team team:work
work:force force:field field:day day:break break:even even:keel
salad:days days:end end:game game:face face:off off:beat beat:down down:play
play:back back:log log:in in:road road:trip trip:wire wire:tap tap:room
cross:word word:play play:ground ground:work work:shop shop:front front:door
door:step step:ladder ladder:back safety:net net:work heavy:hand hand:book
hot:spot spot:light light:house house:hold hold:over over:board board:room
room:mate school:yard yard:stick stick:shift shift:work night:shift
paper:trail trail:blazer wild:card card:shark shark:tank
milk:shake shake:down down:size size:up up:date date:line line:man
chain:mail mail:box box:car car:pool pool:side side:kick kick:back back:fire
fire:works water:works grass:roots sun:glasses head:phones news:paper
sports:car savings:account arms:race odds:maker down:stairs sour:grapes
double:cross cross:bow out:take stock:market market:place place:mat
key:note note:book book:mark mark:up up:town town:hall hall:way way:side
horse:play play:list list:price safe:house house:work eye:sight sight:see
bench:mark land:mark trade:mark bird:song song:bird black:board board:walk
walk:way sand:box box:top pan:cake cake:walk moon:light light:weight
weight:room bar:code code:name name:sake straight:face face:time time:line
life:guard guard:house guard:dog dog:house house:boat boat:house
pin:point point:guard rain:coat coat:tail tail:gate gate:way way:point
snow:ball ball:game ball:room brain:storm storm:cloud cloud:burst
cat:walk fire:place place:holder hand:stand stand:off off:shore shore:line
gold:rush rush:hour hour:glass glass:house drive:way way:lay
foot:note note:worthy heart:beat beat:up up:grade grade:school
mouse:trap trap:door door:bell bell:hop hop:scotch
over:time time:table table:top top:hat hat:trick trick:shot shot:gun gun:fire
tooth:brush brush:fire fire:wall wall:paper paper:back back:pack pack:rat
push:over over:head head:line line:back back:ward
skin:deep deep:end dead:line line:up
free:lance lance:corporal thumb:nail nail:polish polish:off
wind:fall fall:out out:break break:fast fast:track track:record record:player
day:dream dream:land land:slide slide:show show:down down:town
sun:rise rise:above above:board board:game game:show show:room room:service
air:port port:hole hole:punch punch:line line:dance dance:floor floor:plan
plan:view point:man man:hole hole:saw saw:dust dust:bin bin:bag bag:pipe
match:box box:spring spring:board board:shorts
star:fish fish:tank tank:ship ship:yard yard:sale sale:price
pass:word word:smith smith:field
under:dog dog:fight fight:back back:hand hand:cuff cuff:link link:up
lock:down down:pour pour:over over:cast cast:away
turn:coat coat:hanger hanger:on
sound:board board:certified pay:day day:care care:taker taker:down
fool:proof proof:read read:out out:house
gate:crash crash:pad pad:lock lock:smith
flag:ship ship:wreck wreck:age
glass:eye eye:ball ball:point point:break break:through through:way
buzz:word word:count count:down down:load load:out
tail:spin spin:off off:set set:back back:bone bone:dry dry:run run:way
heat:wave wave:length length:wise wise:crack crack:pot pot:luck luck:out
mind:set set:piece piece:meal meal:time time:out out:field field:work
whole:sale sale:room ear:shot shot:put put:down down:beat beat:back
ring:leader leader:board board:member
touch:down down:hill hill:side side:walk walk:out out:side side:step
step:son son:in stone:wall wall:flower flower:bed bed:rock rock:star
star:light light:year year:book book:shelf shelf:space space:craft craft:work
butter:fly fly:wheel wheel:house house:fly fly:paper
corn:bread bread:box box:set set:list list:en
lime:light light:switch switch:board
oat:meal meal:worm worm:hole hole:sale
jack:pot pot:hole hole:some
war:head head:strong strong:hold hold:up up:right right:hand hand:made
horse:shoe shoe:horn horn:blower blower:motor
scare:crow crow:bar bar:tender tender:foot foot:print print:out
tea:pot pot:belly belly:ache
fire:fly fly:over over:run run:down down:fall fall:back
south:paw paw:print
bull:pen pen:knife knife:edge edge:wise
race:track track:suit suit:case case:load load:star
blue:print print:press press:room room:full
gold:smith smith:sonian
camp:fire fire:arm arm:chair chair:man man:power power:play play:off
off:spring spring:time time:piece piece:work work:bench bench:press
press:box box:office office:party party:line line:out"""

for entry in OPEN.split():
    a,b = entry.split(':')
    edges[a].add(b)
    if (a,b) not in pairinfo:
        joined = a+b
        pairinfo[(a,b)] = ('open', round(z(joined,'en'),2) if z(joined,'en')>0 else 0.0, a+' '+b)

print("nodes:", len(edges), "edges:", sum(len(v) for v in edges.values()))
json.dump({f"{a}|{b}": v for (a,b),v in pairinfo.items()}, open('pairs.json','w'))
