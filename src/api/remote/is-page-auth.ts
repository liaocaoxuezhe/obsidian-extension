import fetchClient from "../util/fetch";
import {SvrUri} from "../model/Consts";

const IsPageAuth = async (req:any) => {
    const response = await fetchClient({
        url: SvrUri + "/api/v1/is_page_auth?page_id=" + req.pageId, method: "GET",
        headers: {
            "Access-Token": req.token,
        },
    });
	if (response.code !== 0) {
		console.error("get page is auth error, code: " + response.code)
		return {
			isPageAuth:false
		}
	}

    // 响应
    return {
		isPageAuth: response.data.is_auth
	}
}

export default IsPageAuth
