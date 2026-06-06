import fetchClient from "../util/fetch";
import {SvrUri} from "../model/Consts";

const SaveAuthPageContent = async (req:any) => {
	return await fetchClient({
		url: SvrUri + "/api/v1/obsidian/save_auth_page_content", method: "POST",
		headers: {
			"Access-Token": req.token,
		},
		body:{
			id: req.id,
			title: req.title,
			content: req.content,
			path: req.path,
			last_edit_at: req.lastEditAt,
			is_selected: req.isChecked,
			vault_name: req.vaultName,
		}
	});
}

export default SaveAuthPageContent
