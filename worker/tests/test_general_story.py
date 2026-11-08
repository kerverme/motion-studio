import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from motion_worker.artcheck import check

class GeneralStoryTests(unittest.TestCase):
    def payload(self,code):
        return {'strict_art':True,'script':[{'id':'water','text':'แก้วน้ำกับแสงเช้า'}],'cast':[],'art':'','scenes':[{'seg':'water','type':'custom','code':code}]}
    def test_character_free_scene_reaches_real_artcheck(self):
        r=check(self.payload('def draw(c,t,p):\n    c.grad("sky","cream")\n    c.rect(400,600,240,360,"teal")'))
        self.assertEqual(r['scenes'][0]['errors'],[])
        self.assertEqual(len(r['scenes'][0]['frames']),2)
    def test_character_free_error_cannot_turn_into_generic_mascot(self):
        r=check(self.payload('def draw(c,t,p):\n    c.grad("sky","cream")\n    x = 1 / 0'))
        self.assertTrue(r['scenes'][0]['errors'])
        self.assertEqual(r['scenes'][0]['frames'],[])

if __name__=='__main__':unittest.main()
