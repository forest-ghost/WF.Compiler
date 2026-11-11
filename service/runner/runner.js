import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {mkdtemp, mkdir, open, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {DEVICES, MAX_FILE_BYTES, boundedBytes} from '../src/policy.js';

const base = process.env.COMPILER_SERVICE_URL;
const token = process.env.RUNNER_TOKEN;
if (!base || new URL(base).protocol !== 'https:' || !token) throw Error('Set COMPILER_SERVICE_URL (HTTPS) and RUNNER_TOKEN in the host environment.');
const linux = process.platform === 'linux';
if (!linux && process.platform !== 'win32') throw Error('Use a Linux or Windows Docker host.');
if (linux && (process.getuid() === 0 || process.getgid() === 0)) {
  throw Error('Run the Linux compiler runner under a non-root user and group.');
}
const inputPath = linux ? '/input' : 'C:\\input';
const outputPath = linux ? '/output' : 'C:\\output';
const containerPath = (directory, file) => directory + (linux ? '/' : '\\') + file;
const image = process.env.COMPILER_CONTAINER_IMAGE || 'wherigo-compiler-job';
async function api(path, options = {}) {
  const response = await fetch(new URL(path, base), {...options, signal: AbortSignal.timeout(60_000),
    headers: {Authorization: `Bearer ${token}`, ...options.headers}});
  if (!response.ok) throw Error(`Compiler service returned HTTP ${response.status}.`);
  return response;
}
async function runContainer(inputDirectory, outputDirectory, device) {
  // No shell; device is allowlisted. The job gets only its input/output folders,
  // no network, no service credentials, and no access to the runner's filesystem.
  const name = 'wherigo-' + crypto.randomUUID();
  const args = ['run', '--rm', '--name', name, '--network', 'none', '--memory', '512m', '--cpus', '1',
    '--mount', `type=bind,source=${inputDirectory},target=${inputPath},readonly`,
    '--mount', `type=bind,source=${outputDirectory},target=${outputPath}`];
  if (linux) args.push('--user', `${process.getuid()}:${process.getgid()}`,
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges');
  args.push(image, containerPath(inputPath, 'source.gwz'), device,
    containerPath(outputPath, 'build.gwc'), containerPath(outputPath, 'result.json'));
  await new Promise((resolve, reject) => {
    const child = spawn('docker', args, {stdio: 'ignore', windowsHide: true});
    const timer = setTimeout(() => {
      // Killing docker's client alone does not stop the container.
      const killer = spawn('docker', ['rm', '--force', name], {stdio:'ignore', windowsHide:true});
      killer.on('error', () => {});
      killer.on('close', () => child.kill());
      reject(Error('Compilation exceeded its 60-second limit.'));
    }, 60_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 || code === 1 ? resolve() : reject(Error('The isolated compiler could not start.')); });
  });
}

async function readOutput(path) {
  if (!linux) return readFile(path);
  // The container controls this directory. Open only a regular file and reject
  // links and pipes before reading any bytes from the host.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = await file.stat();
    if (!stats.isFile() || stats.size > MAX_FILE_BYTES) throw Error('Invalid compiler output file.');
    const bytes = Buffer.alloc(stats.size + 1);
    const {bytesRead} = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== stats.size) throw Error('Compiler output changed while reading.');
    return bytes.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

console.log('Compiler runner started. Untrusted cartridges run only in network-isolated containers.');
while (true) {
  try {
    const response = await api('/internal/runner/claim', {method:'POST'});
    if (response.status === 204) { await delay(15_000); continue; }
    const job = await response.json();
    if (!Array.isArray(job.devices) || !job.devices.every(d => DEVICES.includes(d)) || !/^[a-f0-9-]{36}$/.test(job.jobId)) throw Error('Invalid job from compiler service.');
    const headers = {'X-Job-Lease':job.lease};
    const directory = await mkdtemp(join(tmpdir(),'wherigo-compile-'));
    try {
      const input = join(directory,'input'); await mkdir(input);
      const source = await api(`/internal/runner/${job.jobId}/source`, {headers});
      await writeFile(join(input,'source.gwz'),await boundedBytes(source));
      const results = [];
      for (const device of job.devices) {
        const output = join(directory,device); await mkdir(output);
        try {
          await runContainer(input,output,device);
          const report = JSON.parse((await readOutput(join(output,'result.json'))).toString('utf8'));
          if (report.device !== device || typeof report.ok !== 'boolean') throw Error('Invalid compiler result.');
          if (report.ok && job.downloads.includes(device)) {
            const bytes = await readOutput(join(output,'build.gwc'));
            if (bytes.length > MAX_FILE_BYTES) throw Error('Compiled file exceeds 20 MB.');
            await api(`/internal/runner/${job.jobId}/build/${device}`, {method:'PUT',headers,body:bytes});
          }
          results.push(report);
        } catch (error) { results.push({device,ok:false,messages:[error.message]}); }
      }
      await api(`/internal/runner/${job.jobId}/complete`, {method:'POST',headers,body:JSON.stringify({results})});
    } finally { await rm(directory, {recursive:true,force:true}); }
  } catch (error) { console.error(error.message); await delay(15_000); }
}
