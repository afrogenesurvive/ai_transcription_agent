declare module "pidusage" {
  interface Stat {
    cpu: number;
    memory: number;
    elapsed: number;
    pid: number;
    ppid: number;
  }

  function pidusage(pids: number[]): Promise<Record<string, Stat>>;
  function pidusage(pid: number): Promise<Stat>;
  export default pidusage;
}
