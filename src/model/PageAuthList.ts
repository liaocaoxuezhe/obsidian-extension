export interface PageAuthItem {
	id: string
	name: string
	isChecked: boolean
	path: string
	type: string
	vaultName: string
	createAt: number
	updateAt: number
	children: PageAuthItem[]
	isSync:boolean
}

export function BuildPageId(path:string|undefined, ctime:number|undefined):string {
	return (path + (ctime ? "-" + ctime : "")).split("/").join("-")
}
