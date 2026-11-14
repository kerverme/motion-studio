declare module 'jev-social' {
  export function runSearch(input:any,options?:any):Promise<any>;
  export function probeSocai(config?:any,env?:any,signal?:AbortSignal,options?:any):Promise<any>;
}
