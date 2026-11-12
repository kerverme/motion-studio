import base64, unittest
from unittest.mock import patch
from motion_worker import eleven


class CreativeAudioTests(unittest.TestCase):
    def fixture(self,text='ฝัน'):
        a={'characters':list(text),'character_start_times_seconds':[i*.1 for i in range(len(text))],'character_end_times_seconds':[(i+1)*.1 for i in range(len(text))]}
        return {'audio_base64':base64.b64encode(b'mocked-mp3').decode(),'normalized_alignment':a,'voice_segments':[{'voice_id':'voice-original','start_time_seconds':0,'end_time_seconds':.3,'character_start_index':0,'character_end_index':len(text),'dialogue_input_index':0}]}
    def test_v4_uses_dialogue_settings_original_voice_and_real_alignment(self):
        with patch.object(eleven,'_post',return_value=(self.fixture(),{'request_id':'mock'})) as post:
            _,a,m=eleven.tts_with_timestamps('ฝัน','voice-original',speed=1.1)
            args,kwargs=post.call_args
            self.assertEqual(args[0],'/v1/text-to-dialogue/with-timestamps');self.assertEqual(args[1]['inputs'],[{'text':'ฝัน','voice_id':'voice-original'}])
            self.assertNotIn('voice_settings',args[1]);self.assertEqual(args[1]['model_id'],'eleven_v4');self.assertEqual(kwargs['attempts'],1)
            self.assertEqual(''.join(a['characters']),'ฝัน');self.assertEqual(m['alignment_source'],'normalized_alignment')
    def test_unsupported_v4_does_not_bill_another_model(self):
        with patch.object(eleven,'_post',side_effect=eleven.ElevenError('400 unsupported model')) as post:
            with self.assertRaises(eleven.ElevenError):eleven.tts_with_timestamps('ฝัน','voice-original')
            self.assertEqual(post.call_count,1)
    def test_invalid_or_missing_timing_is_never_estimated(self):
        data=self.fixture();data['normalized_alignment']['character_start_times_seconds'][1]=float('nan')
        with self.assertRaises(eleven.ElevenError):eleven.validated_alignment(data,'ฝัน')
        with self.assertRaises(eleven.ElevenError):eleven.validated_alignment(self.fixture(),'กิน')
        with self.assertRaises(eleven.ElevenError):eleven.validated_alignment({},'ฝัน')
    def test_sfx_v3_explicit_model_and_no_unsupported_loop(self):
        with patch.object(eleven,'_post',return_value=(b'mock-sfx',{})) as post:
            _,meta=eleven.sound_effect('wood tap',1,model_id='eleven_text_to_sound_v3')
            self.assertEqual(post.call_args.args[1]['model_id'],'eleven_text_to_sound_v3');self.assertEqual(meta['duration'],1)
            with self.assertRaises(eleven.ElevenError):eleven.sound_effect('wood tap',1,model_id='eleven_text_to_sound_v3',loop=True)
            self.assertEqual(post.call_count,1)


if __name__=='__main__':unittest.main()
