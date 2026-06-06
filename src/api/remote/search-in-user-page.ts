import fetchClient from "../util/fetch";
import {SvrUri} from "../model/Consts";

const SearchUserPageList = async (req:any) => {
	return await fetchClient({
        url: SvrUri + "/api/v1/search", method: "POST",
        headers: {
            "Access-Token": req.token,
        },
        body: {
            page_id: req.pageId,
            url: req.url,
            content: req.content,
            is_default_search: req.isDefault
        }
    });
}

export default SearchUserPageList
