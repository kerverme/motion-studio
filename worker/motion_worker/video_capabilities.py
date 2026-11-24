"""Read-only provider model and pricing probes for quotes and dispatch revalidation."""
from html.parser import HTMLParser
import json
import os
import re
import time

import requests
from . import config

VOICE_MODELS = ('eleven_v4','eleven_v3')
SFX_MODELS = ('eleven_text_to_sound_v3','eleven_text_to_sound_v2')
PRICE_SOURCE = 'https://elevenlabs.io/pricing/api'
SFX_SOURCE = 'https://elevenlabs.io/docs/overview/capabilities/sound-effects.md'
SFX_SCHEMA = 'https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert.md'
PUBLIC_HEADERS = {'User-Agent':'MotionStudio/1.0'}


class PriceCards(HTMLParser):
    def __init__(self):
        super().__init__()
        self.labels = []
        self.hidden = 0

    def handle_starttag(self, tag, attrs):
        if tag in ('script','style'):
            self.hidden += 1

    def handle_endtag(self, tag):
        if tag in ('script','style'):
            self.hidden = max(0,self.hidden-1)

    def handle_data(self, text):
        if not self.hidden and text.strip() and len(text) < 300:
            self.labels.append(' '.join(text.split()))

    def rate(self, product, category, unit):
        prices = set()
        for i in range(len(self.labels)-3):
            if self.labels[i:i+2] != [product,category]:
                continue
            j = i+2
            if self.labels[j] == 'New':
                j += 1
            if j+1 < len(self.labels) and self.labels[j+1] == unit and re.fullmatch(r'\$[0-9]+(?:\.[0-9]+)?',self.labels[j]):
                prices.add(float(self.labels[j][1:]))
        return prices.pop() if len(prices)==1 else None


def official_text(url):
    res = requests.get(url,headers=PUBLIC_HEADERS,timeout=15,allow_redirects=False)
    res.raise_for_status()
    if res.status_code != 200 or len(res.content) > 3*1024*1024:
        raise ValueError('Official pricing page unavailable')
    return res.text


def audio_offer():
    result = {'voice_model':None,'voice_models':[],'voice_usd_per_1000_characters':None,'sfx_models':[],
              'sfx_usd_per_second':None,'sfx_credits_per_second':None,'audio_pricing_source':PRICE_SOURCE}
    if not config.ELEVENLABS_API_KEY:
        return result
    try:
        res = requests.get(config.ELEVENLABS_BASE+'/v1/models',headers={'xi-api-key':config.ELEVENLABS_API_KEY},timeout=12,allow_redirects=False)
        res.raise_for_status()
        live = {m['model_id'] for m in res.json()}
        result['voice_models'] = [name for name in VOICE_MODELS if name in live]
        parser = PriceCards()
        parser.feed(official_text(PRICE_SOURCE))
        for voice in result['voice_models']:
            rate = parser.rate(voice.removeprefix('eleven_'),'Text to Speech','Price per 1K characters')
            if rate and rate > 0:
                result.update(voice_model=voice,voice_usd_per_1000_characters=rate)
                break
        schema, guide = official_text(SFX_SCHEMA), official_text(SFX_SOURCE)
        enum = next((line for line in schema.splitlines() if 'Allowed values' in line and 'eleven_text_to_sound_' in line),'')
        match = re.search(r'Cost:\s*([0-9]+(?:\.[0-9]+)?) credits per second when duration is specified',guide)
        price = parser.rate('Sound Effects','Audio Generation','Price per minute')
        if match and price and price > 0:
            result.update(sfx_models=[m for m in SFX_MODELS if m in enum],sfx_credits_per_second=float(match[1]),
                          sfx_pricing_source=SFX_SOURCE,sfx_usd_per_second=price/60)
    except (ValueError,KeyError,TypeError,requests.RequestException):
        pass
    return result


def probe():
    result = {'production_version':2,'verified_media_trim':True,'qa':False,
              'capabilities_checked_at':time.time(),**audio_offer()}
    try:
        model = os.environ.get('MOTION_REVERSE_BRAIN_MODEL','gpt-6.2-sol')
        rate = json.loads(os.environ.get('MOTION_REVERSE_OPENAI_RATE_JSON','null'))
        if os.environ.get('OPENAI_API_KEY') and rate and rate.get('model') == model:
            response = requests.get('https://api.openai.com/v1/models/'+model,headers={'Authorization':'Bearer '+os.environ['OPENAI_API_KEY']},
                                    timeout=12,allow_redirects=False)
            if response.ok and response.json().get('id') == model:
                result.update(qa=True,qa_model=model,qa_rate=rate)
    except (ValueError,requests.RequestException):
        pass
    return result
