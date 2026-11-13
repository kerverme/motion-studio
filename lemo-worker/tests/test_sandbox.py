import io,json,os,sys,tarfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'sandbox'))
from executor import command,validate_archive,verify_runtime,kernel_limits,run


class SandboxTests(unittest.TestCase):
    def test_command_has_fixed_limits_no_mounts_no_environment(self):
        args=command('sha256:'+'a'*64,'test')
        for flag in ['--runtime=runsc','--network=none','--read-only','--user=65534:65534','--cap-drop=ALL','--cpus=2','--memory=2g','--pids-limit=1024']:self.assertIn(flag,args)
        self.assertFalse(any(x in args for x in ['-v','--mount','--privileged','-e','--env-file']))
        with self.assertRaises(ValueError):command('image:latest','test')
    def test_archive_rejects_symlink_and_paths(self):
        buf=io.BytesIO()
        with tarfile.open(fileobj=buf,mode='w') as tar:
            t=tarfile.TarInfo('../../escape');t.type=tarfile.SYMTYPE;t.linkname='/etc/passwd';tar.addfile(t)
        with self.assertRaises(ValueError):validate_archive(buf.getvalue())
    def test_missing_cgroup_evidence_blocks_generated_code(self):
        result=type('Result',(),{'returncode':1,'stdout':''})()
        with patch('executor.subprocess.run',return_value=result):
            with self.assertRaisesRegex(RuntimeError,'resource enforcement'):verify_runtime('sha256:'+'a'*64)
    def test_kernel_limits_require_actual_pid_membership_and_bounded_cpu(self):
        cid='a'*64;pid=12345
        data={'/proc/12345/cgroup':'0::/docker/'+cid,'cgroup.procs':str(pid),'memory.max':'2147483648','memory.swap.max':'0','cpu.max':'200000 100000','pids.max':'1024'}
        def read(path,*args,**kwargs):return data.get(str(path),data.get(path.name,''))
        with patch.object(Path,'read_text',read):
            self.assertEqual(kernel_limits(pid,cid)['evidence'],'host-kernel-cgroup-v2')
            data['cpu.max']='max 100000'
            with self.assertRaises((ValueError,RuntimeError)):kernel_limits(pid,cid)
            data['cpu.max']='200000 100000';data['cgroup.procs']='different-pid'
            with self.assertRaisesRegex(RuntimeError,'PID'):kernel_limits(pid,cid)
            data['cgroup.procs']=str(pid);data['memory.max']='max'
            with self.assertRaisesRegex(RuntimeError,'limit'):kernel_limits(pid,cid)
    def test_fixture_exception_cannot_run_arbitrary_source(self):
        with self.assertRaisesRegex(ValueError,'immutable fixtures'):run({'html':'arbitrary generated code','duration':1},image='sha256:'+'a'*64,trusted_fixture=True)
    def test_library_hash_and_style_ids_match_the_pinned_checkout(self):
        import hashlib
        root=Path(__file__).resolve().parents[1];lock=json.loads((root/'upstream.lock.json').read_text())
        self.assertEqual(hashlib.sha256((root/'vendor/lemo/core/lib.js').read_bytes()).hexdigest(),lock['code_sha256'])
        self.assertEqual({s['id'] for s in lock['styles']},{'dataviz','firefly-pointillism','rubber-hose'})
        self.assertFalse(list((root/'vendor').rglob('STYLE.md')))


if __name__=='__main__':unittest.main()
