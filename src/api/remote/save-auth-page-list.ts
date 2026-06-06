import fetchClient from "../util/fetch";
import {SvrUri} from "../model/Consts";

const SaveAuthPageList = async (req:any) => {
	let list:any[] = []
	req.pageList.forEach((val:any, _: any) => {
		list.push({
			id: val.id,
			title: val.title,
			content: "",
			is_checked: val.isChecked,
			path: val.path,
			last_edit_at: val.updateAt,
			vault_name: val.vaultName,
			create_at: val.createAt,
			update_at: val.updateAt,
		})
		return
	})
	return await fetchClient({
		url: SvrUri + "/api/v1/obsidian/save_auth_page_list", method: "POST",
		headers: {
			"Access-Token": req.token,
		},
		body:{
			list: list,
		}
	});
}

export default SaveAuthPageList
